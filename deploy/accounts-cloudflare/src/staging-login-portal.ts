import type { TakosumiAccountsAuthProvider } from "@takosjp/takosumi-accounts-contract";

import { authLanguage, authPage, authSignInTitle, escapeAuthHtml as escapeHtml, stagingSignInProduct } from "../../../accounts/service/src/auth-page.ts";
import { AUTH_STAGING_CLIENTS, AUTH_STAGING_ISSUER as stagingIssuer } from "./staging-target.ts";

const portalCopy = {
  en: {
    title: "Sign in",
    otherMethods: "or",
    setUsername: "Set a username",
    stage: "Staging",
    notFound: "Not found",
    method: "Reopen this page to sign in.",
    invalid: "This sign-in link is invalid. Try again from your app.",
    unavailable: "Sign-in is temporarily unavailable. Try again later from your application.",
    fresh: "Sign in again to continue.",
    start: "Start sign-in from Takosumi Hosted or Takoserver.",
    githubFresh: "Use Google to sign in again.",
    provider: (label: string) => `Continue with ${label}`,
  },
  ja: {
    title: "ログイン",
    otherMethods: "または",
    setUsername: "ユーザー名を設定",
    stage: "ステージング",
    notFound: "ページが見つかりません。",
    method: "このページを開き直してください。",
    invalid: "このサインインリンクは無効です。元のアプリからやり直してください。",
    unavailable: "現在サインインできません。時間をおいて、元のアプリからやり直してください。",
    fresh: "もう一度ログインしてください。",
    start: "Takosumi または Takoserver を開いて、サインインを始めてください。",
    githubFresh: "再ログインには Google を使ってください。",
    provider: (label: string) => `${label} で続ける`,
  },
} as const;

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
  const language = authLanguage(input.request);
  const copy = portalCopy[language];
  const host = input.request.headers.get("host");
  if (input.issuer !== stagingIssuer || url.origin !== stagingIssuer ||
    url.username || url.password || url.hash ||
    (host !== null && host !== "auth-staging.takos.jp" && host !== "auth-staging.takos.jp:443")) {
    return portalResponse(input.request, copy.notFound, 404);
  }
  if (input.request.method !== "GET" && input.request.method !== "HEAD") {
    return portalResponse(input.request, copy.method, 405, { allow: "GET, HEAD" });
  }

  let continuation: ReturnType<typeof validateContinuation>;
  try {
    continuation = validateContinuation(url);
  } catch {
    return portalResponse(input.request, copy.invalid, 400);
  }
  if (!input.accountsHandler) return portalResponse(input.request, copy.unavailable, 503);

  try {
    // The configured issuer and public in-process route are the only inputs.
    // Cookies, host forwarding and caller-supplied provider payloads are absent.
    const providerResponse = await input.accountsHandler(new Request(`${stagingIssuer}/api/v1/auth/providers`, {
      headers: { accept: "application/json" },
    }));
    const { providers, passwordEnabled } = await readProviders(providerResponse);
    if (providers.length === 0 && !passwordEnabled) return portalResponse(input.request, copy.unavailable, 503);
    if (continuation.returnTo === "/account" && !passwordEnabled) return portalResponse(input.request, copy.invalid, 400);
    const returnTo = continuation.returnTo ?? (passwordEnabled ? "/account" : undefined);
    const choices = providers.map((provider) => {
      const label = escapeHtml(provider.label);
      const icon = providerIcon(provider.id);
      if (!returnTo) return `<li class="auth-provider-label">${icon}${label}</li>`;
      if (continuation.fresh && provider.id === "github") {
        return `<li><button class="auth-button auth-provider-choice" type="button" disabled>${icon}${label}</button><p class="auth-hint">${copy.githubFresh}</p></li>`;
      }
      const target = new URL("/oauth/upstream/authorize", stagingIssuer);
      target.searchParams.set("provider", provider.id);
      target.searchParams.set("return_to", returnTo);
      if (continuation.fresh) {
        target.searchParams.set("prompt", "login");
        target.searchParams.set("max_age", continuation.maxAge ?? "0");
      }
      return `<li><a class="auth-button auth-provider-choice" href="${escapeHtml(target.pathname + target.search)}">${icon}<span>${escapeHtml(copy.provider(provider.label))}</span></a></li>`;
    }).join("");
    const explanation = returnTo ? (continuation.fresh ? copy.fresh : "") : copy.start;
    return portalResponse(input.request, explanation, 200, {}, {
      choices,
      passwordReturn: passwordEnabled ? returnTo : undefined,
      product: continuation.product,
    });
  } catch {
    return portalResponse(input.request, copy.unavailable, 503);
  }
}

function validateContinuation(url: URL): { returnTo?: string; fresh: boolean; maxAge?: string; product?: string } {
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
  // The management return is admitted only after password capability is checked.
  if (rawReturn === "/account") return { returnTo: rawReturn, fresh: prompt === "login" || maxAge !== null,
    ...(maxAge !== null ? { maxAge } : {}) };
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
  const client = AUTH_STAGING_CLIENTS.find(({ clientId, redirectUris }) =>
    clientId === target.searchParams.get("client_id") &&
    redirectUris.some((uri) => uri === target.searchParams.get("redirect_uri")),
  );
  const product = client ? stagingSignInProduct(client.clientId) : undefined;
  return {
    returnTo: target.pathname + target.search,
    ...(product ? { product } : {}),
    fresh: prompt === "login" || maxAge !== null || authorizationPrompt.includes("login") || authorizationMaxAge === "0",
    ...(maxAge !== null ? { maxAge } : {}),
  };
}

async function readProviders(response: Response): Promise<{ providers: TakosumiAccountsAuthProvider[]; passwordEnabled: boolean }> {
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
  if (body.password !== undefined && (!isRecord(body.password) || typeof body.password.enabled !== "boolean")) {
    throw new TypeError("invalid password capability");
  }
  return { providers: result, passwordEnabled: isRecord(body.password) && body.password.enabled === true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function portalResponse(
  request: Request,
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {},
  { choices = "", passwordReturn, product }: { choices?: string; passwordReturn?: string; product?: string } = {},
): Response {
  const language = authLanguage(request);
  const copy = portalCopy[language];
  const nonce = crypto.randomUUID();
  const password = passwordReturn ? passwordForm(language, nonce, passwordReturn) : "";
  const divider = password && choices ? `<p class="auth-divider">${copy.otherMethods}</p>` : "";
  const providers = choices ? `<ul class="auth-providers">${choices}</ul>` : "";
  const setup = passwordReturn?.startsWith("/oauth/authorize?")
    ? `<p class="auth-summary"><a class="auth-setup-link" href="/account">${copy.setUsername}</a></p>`
    : "";
  const html = authPage({
    language, nonce, issuer: stagingIssuer, badge: copy.stage,
    title: product ? authSignInTitle(language, product) : copy.title,
    description: message, body: password + divider + providers + setup,
  });
  return new Response(request.method === "HEAD" ? null : html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-language": language,
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; ${passwordReturn ? `script-src 'nonce-${nonce}'; connect-src 'self'; ` : ''}base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      "referrer-policy": "no-referrer",
      ...extraHeaders,
    },
  });
}


const passwordCopy = {
  en: {
    title: "Sign in with a password", username: "Username", password: "Password", noScript: "Enable JavaScript to sign in with a password.",
    failed: "We couldn't complete this request. Check your details and try again.", credentials: "We couldn't verify these details. Check them and try again.",
    rateLimited: "Too many attempts. Wait a while before trying again.", unavailable: "Password sign-in is currently unavailable. Try again later or use another method.",
  },
  ja: {
    title: "パスワードでログイン", username: "ユーザー名", password: "パスワード", noScript: "パスワードでログインするにはJavaScriptを有効にしてください。",
    failed: "操作を完了できませんでした。入力内容を確かめて、もう一度お試しください。", credentials: "入力内容を確認できませんでした。内容を確かめて、もう一度お試しください。",
    rateLimited: "試行回数が多くなっています。しばらく待ってから、もう一度お試しください。", unavailable: "現在、パスワードによるサインインは利用できません。時間をおくか、別の方法をお使いください。",
  },
} as const;

function passwordForm(language: "ja" | "en", nonce: string, returnTo: string): string {
  const copy = passwordCopy[language];
  const h = escapeHtml;
  const messages = JSON.stringify(copy).replace(/</gu, "\\u003c");
  return `<style nonce="${h(nonce)}">
.auth-password fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: var(--auth-space-sm); min-width: 0; }
.auth-password label { display: grid; gap: .25rem; font-size: .8125rem; }
.auth-password input { width: 100%; min-width: 0; min-height: 2.75rem; padding: .5rem; border: 1px solid var(--auth-control-border); border-radius: .5rem; background: var(--auth-panel); color: var(--auth-fg); font: 400 1rem var(--auth-font); }
.auth-password input:focus-visible { outline: 2px solid var(--auth-accent); outline-offset: 2px; }
#password-error:empty { display: none; }
.auth-setup-link { color: var(--auth-fg); text-underline-offset: .2em; }
</style>
<section class="auth-password" id="password-root" data-return-path="${h(returnTo)}">
<form id="password-form" method="post" action="/api/v1/auth/password/login" aria-label="${h(copy.title)}"><fieldset id="password-fields">
<label>${h(copy.username)}<input name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
<label>${h(copy.password)}<input name="password" type="password" autocomplete="current-password" required></label>
<button class="auth-button auth-button--primary" type="submit">${h(copy.title)}</button>
</fieldset></form><p class="warn" id="password-error" role="alert"></p><noscript><p>${h(copy.noScript)}</p></noscript></section>
<script nonce="${h(nonce)}">(() => {
"use strict";
const copy = ${messages};
const root = document.getElementById("password-root");
const form = document.getElementById("password-form");
const fields = document.getElementById("password-fields");
const error = document.getElementById("password-error");
const controller = new AbortController();
let busy = false;
addEventListener("pagehide", () => { controller.abort(); form.reset(); });
document.addEventListener("click", (event) => {
  if (busy && event.target instanceof Element && event.target.closest(".auth-providers a")) event.preventDefault();
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const values = new FormData(form);
  busy = true; fields.disabled = true; error.textContent = "";
  try {
    const response = await fetch("/api/v1/auth/password/login", { method: "POST", credentials: "same-origin", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: String(values.get("username") || "").trim(), password: String(values.get("password") || "") }) });
    if (!response.ok) { error.textContent = response.status === 429 ? copy.rateLimited : response.status === 401 || response.status === 403 ? copy.credentials : response.status === 404 || response.status === 503 ? copy.unavailable : copy.failed; return; }
    const result = await response.json();
    if (!result || typeof result.subject !== "string" || !result.subject) throw new Error("invalid response");
    if (controller.signal.aborted) return;
    form.reset(); location.assign(root.dataset.returnPath);
  } catch { if (!controller.signal.aborted) error.textContent = copy.failed; }
  finally { busy = false; fields.disabled = false; }
});
})();</script>`;
}

// Provider marks are static presentation, never returned by provider discovery.
// Google geometry matches the existing Takoserver sign-in glyph.
function providerIcon(provider: string): string {
  const body = provider === "google"
    ? `<path fill="var(--auth-google-blue)" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z"/><path fill="var(--auth-google-green)" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24Z"/><path fill="var(--auth-google-yellow)" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1Z"/><path fill="var(--auth-google-red)" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z"/>`
    : `<path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6A4.7 4.7 0 0 1 5.6 8.5c-.1-.3-.5-1.6.1-3.3 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.3 3 .2 3.3a4.7 4.7 0 0 1 1.2 3.2c0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z"/>`;
  return `<svg class="auth-provider-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${body}</svg>`;
}
