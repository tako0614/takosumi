import type { TakosumiAccountsAuthProvider } from "@takosjp/takosumi-accounts-contract";

import { authLanguage, authPage, escapeAuthHtml as escapeHtml } from "../../../accounts/service/src/auth-page.ts";

const stagingIssuer = "https://auth-staging.takos.jp";
const portalCopy = {
  en: {
    title: "Sign in",
    stage: "Staging",
    notFound: "Not found",
    method: "Use a GET request to open sign-in.",
    invalid: "This sign-in link is invalid. Start sign-in again from Takosumi Hosted or Takoserver.",
    unavailable: "Sign-in is temporarily unavailable. Try again later from your application.",
    fresh: "Confirm a fresh sign-in to continue to your application.",
    choose: "Use your Takos account with Takosumi and Takoserver.",
    start: "Start sign-in from Takosumi Hosted or Takoserver.",
    methods: "Sign-in methods",
    githubFresh: "GitHub cannot confirm fresh credential entry for this request. Use Google to confirm your sign-in.",
    provider: (label: string) => `Continue with ${label}`,
  },
  ja: {
    title: "サインイン",
    stage: "ステージング",
    notFound: "ページが見つかりません。",
    method: "サインイン画面は GET で開いてください。",
    invalid: "このサインインリンクは無効です。Takosumi Hosted または Takoserver からやり直してください。",
    unavailable: "現在サインインできません。時間をおいて、元のアプリからやり直してください。",
    fresh: "アプリに戻る前に、もう一度本人確認をしてください。",
    choose: "ひとつの Takos アカウントで、Takosumi と Takoserver を使えます。",
    start: "Takosumi または Takoserver を開いて、サインインを始めてください。",
    methods: "サインイン方法",
    githubFresh: "GitHub ではこの操作に必要な再認証を確認できません。Google でサインインしてください。",
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

  let continuation: { returnTo?: string; fresh: boolean; maxAge?: string };
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
    const providers = await readProviders(providerResponse);
    if (providers.length === 0) return portalResponse(input.request, copy.unavailable, 503);
    const choices = providers.map((provider) => {
      const label = escapeHtml(provider.label);
      if (!continuation.returnTo) return `<li class="auth-provider-label">${label}</li>`;
      if (continuation.fresh && provider.id === "github") {
        return `<li><button class="auth-button auth-provider-choice" type="button" disabled>${label}</button><p class="auth-hint">${copy.githubFresh}</p></li>`;
      }
      const target = new URL("/oauth/upstream/authorize", stagingIssuer);
      target.searchParams.set("provider", provider.id);
      target.searchParams.set("return_to", continuation.returnTo);
      if (continuation.fresh) {
        target.searchParams.set("prompt", "login");
        target.searchParams.set("max_age", continuation.maxAge ?? "0");
      }
      return `<li><a class="auth-button auth-provider-choice" href="${escapeHtml(target.pathname + target.search)}">${escapeHtml(copy.provider(provider.label))}</a></li>`;
    }).join("");
    const explanation = continuation.returnTo ? (continuation.fresh ? copy.fresh : copy.choose) : copy.start;
    return portalResponse(input.request, explanation, 200, {}, `<ul class="auth-providers">${choices}</ul>`);
  } catch {
    return portalResponse(input.request, copy.unavailable, 503);
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

function portalResponse(request: Request, message: string, status: number, extraHeaders: Record<string, string> = {}, choices = ""): Response {
  const language = authLanguage(request);
  const copy = portalCopy[language];
  const nonce = crypto.randomUUID();
  const html = authPage({ language, nonce, title: copy.title, badge: copy.stage,
    description: message, taskTitle: copy.methods, body: choices });
  return new Response(request.method === "HEAD" ? null : html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-language": language,
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      "referrer-policy": "no-referrer",
      ...extraHeaders,
    },
  });
}
