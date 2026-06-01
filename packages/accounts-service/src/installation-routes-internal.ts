/**
 * Internal-only helpers extracted from `installation-routes.ts` during the
 * Takosumi v1 contract reset (Wave 6).
 *
 * - OIDC value validators (`oidcRedirectUrisValue`, `oidcIssuerUrlValue`,
 *   `oidcClientAuthMethodValue`, etc.) are sibling-package internals shared
 *   between the install-lifecycle handlers and use-takos start route.
 * - `handleIssueLaunchToken` and its support helpers
 *   (`launchRedirectUrl`, `resolveLaunchTokenPairwiseSubject`,
 *   `opaqueLaunchToken`, `launchTokenConsumeError`) back the in-package
 *   `/start` and `/dashboard/use-takos` issue flows. Token issue is not a
 *   public app route; token consume remains public so installed apps can
 *   redeem the one-shot launch token.
 * - `requireInstallationAccessTokenCapability` gates internal bearer-token
 *   checks for the same flows.
 *
 * None of these are re-exported from the package barrel.
 */
import {
  normalizeIssuer,
  type TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import type { AppGrantCapability, InstallationRecord } from "./ledger.ts";
import type {
  AccountsStore,
  OidcClientAuthMethod,
  TokenRecord,
} from "./store.ts";
import { derivePairwiseSubject } from "./subject.ts";
import { base64UrlEncodeBytes, sha256Text } from "./encoding.ts";
import { appendLedgerEvent } from "./installation-helpers.ts";
import { includesScope, tokenScopesRemainGranted } from "./oidc-routes.ts";
import {
  bearerChallenge,
  bearerToken,
  json,
  numberValue,
  readJsonObject,
  stringArrayValue,
  stringValue,
} from "./http-helpers.ts";
import type { LaunchTokenOptions } from "./mod.ts";

/**
 * Internal launch-token issuer. Wave 6 removed
 * `POST /v1/installations/{id}/launch-token` from the public surface; this
 * helper is now only reachable from internal routes (`/start` /
 * `/dashboard/use-takos`) that drive the install→launch handshake from the
 * operator-controlled dashboard. Do not export over HTTP.
 */
export async function handleIssueLaunchToken(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
  issuer: string;
  launchTokens: LaunchTokenOptions;
}): Promise<Response> {
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return json({ error: "installation_not_found" }, 404);
  if (installation.status !== "ready") {
    return json({
      error: "state_conflict",
      error_description:
        "launch tokens can only be issued for ready installations",
    }, 409);
  }

  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const purpose =
    body.purpose === "install-bootstrap" || body.purpose === "re-launch"
      ? body.purpose
      : "install-bootstrap";
  const requestedTtlSeconds = numberValue(body.max_lifetime_seconds) ??
    numberValue(body.maxLifetimeSeconds) ?? numberValue(body.ttlSeconds) ??
    300;
  const ttlSeconds = Math.min(Math.max(requestedTtlSeconds, 1), 300);
  const redirectUri = stringValue(body.redirect_uri) ??
    stringValue(body.redirectUri);
  if (!redirectUri) {
    return json({
      error: "invalid_request",
      error_description: "redirect_uri is required",
    }, 400);
  }
  const redirect = launchRedirectUrl(redirectUri);
  if (!redirect) {
    return json({
      error: "invalid_request",
      error_description:
        "redirectUri must be an absolute /_takosumi/launch URL",
    }, 400);
  }

  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;
  const jti = `lt_${crypto.randomUUID()}`;
  const subject = await resolveLaunchTokenPairwiseSubject({
    store: input.store,
    installation,
    launchTokens: input.launchTokens,
  });
  if (subject instanceof Response) return subject;
  const token = opaqueLaunchToken();
  const tokenHash = await sha256Text(`takosumi-launch-token:${token}`);
  const scope = stringArrayValue(body.scope) ?? ["openid", "email", "profile"];
  const boundRedirectUri = redirect.toString();
  await input.store.saveLaunchToken({
    tokenHash,
    jti,
    installationId: installation.installationId,
    accountId: installation.accountId,
    spaceId: installation.spaceId,
    appId: installation.appId,
    subject,
    redirectUri: boundRedirectUri,
    scope,
    expiresAt,
    createdAt: now,
  });
  redirect.searchParams.set("launch_token", token);
  await appendLedgerEvent(input.store, {
    installationId: input.installationId,
    eventType: "installation.launch_token_issued",
    payload: {
      purpose,
      jti,
      tokenType: "opaque",
      expiresAt,
      redirectUri: boundRedirectUri,
    },
    now,
  });

  return json({
    url: redirect.toString(),
    token,
    token_type: "opaque",
    expiresAt: new Date(expiresAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    jti,
    installation_id: installation.installationId,
    redirect_uri: boundRedirectUri,
  });
}

export async function handleConsumeLaunchToken(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const token = stringValue(body.token ?? body.launch_token);
  const redirectUri = stringValue(body.redirect_uri ?? body.redirectUri);
  if (!token || !redirectUri) {
    return json({
      error: "invalid_request",
      error_description: "token and redirect_uri are required",
    }, 400);
  }
  const redirect = launchRedirectUrl(redirectUri);
  if (!redirect) {
    return json({
      error: "invalid_request",
      error_description:
        "redirectUri must be an absolute /_takosumi/launch URL",
    }, 400);
  }

  const now = Date.now();
  const result = await input.store.consumeLaunchToken({
    tokenHash: await sha256Text(`takosumi-launch-token:${token}`),
    installationId: input.installationId,
    redirectUri: redirect.toString(),
    consumedAt: now,
  });
  if (!result.ok) {
    const status = result.reason === "not_found"
      ? 404
      : result.reason === "expired" || result.reason === "used"
      ? 409
      : 400;
    return json({
      error: launchTokenConsumeError(result.reason),
    }, status);
  }
  const record = result.record;
  await appendLedgerEvent(input.store, {
    installationId: input.installationId,
    eventType: "installation.launch_token_consumed",
    payload: {
      jti: record.jti,
      tokenType: "opaque",
      redirectUri: record.redirectUri,
      subject: record.subject,
      consumedAt: now,
    },
    now,
  });
  return json({
    consumed: true,
    installation_id: record.installationId,
    account_id: record.accountId,
    space_id: record.spaceId,
    app_id: record.appId,
    sub: record.subject,
    subject: record.subject,
    role: "owner",
    jti: record.jti,
    audience: record.redirectUri,
    scope: record.scope,
    expires_at: new Date(record.expiresAt).toISOString(),
  });
}

export function launchTokenConsumeError(
  reason: "not_found" | "redirect_mismatch" | "expired" | "used",
): string {
  if (reason === "redirect_mismatch") return "launch_token_redirect_mismatch";
  if (reason === "expired") return "launch_token_expired";
  if (reason === "used") return "launch_token_replayed";
  return "invalid_launch_token";
}

export async function resolveLaunchTokenPairwiseSubject(input: {
  store: AccountsStore;
  installation: InstallationRecord;
  launchTokens: LaunchTokenOptions;
}): Promise<TakosumiSubject | Response> {
  if (!input.launchTokens.pairwiseSubjectSecret) {
    return json({
      error: "feature_unavailable",
      error_description: "App launch is temporarily unavailable.",
    }, 503);
  }
  const oidcClient = await input.store.findOidcClientForInstallation(
    input.installation.installationId,
  );
  const clientId = oidcClient
    ? [
      input.installation.appId,
      input.installation.installationId,
      oidcClient.clientId,
    ].join(":")
    : [
      input.installation.appId,
      input.installation.installationId,
      "launch-token",
    ].join(":");
  return await derivePairwiseSubject({
    secret: input.launchTokens.pairwiseSubjectSecret,
   takosumiSubject: input.installation.createdBySubject,
    clientId,
  });
}

export async function requireInstallationAccessTokenCapability(input: {
  request: Request;
  store: AccountsStore;
  installationId: string;
  capability: AppGrantCapability;
}): Promise<
  | { ok: true; record: TokenRecord }
  | { ok: false; response: Response }
> {
  const accessToken = bearerToken(input.request.headers.get("authorization"));
  if (!accessToken) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  const record = await input.store.findAccessToken(accessToken);
  if (!record || record.expiresAt < Date.now()) {
    if (record) await input.store.deleteToken(accessToken);
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  if (record.installationId !== input.installationId) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  if (!includesScope(record.scope, input.capability)) {
    return {
      ok: false,
      response: json({ error: "insufficient_scope" }, 403, {
        "www-authenticate":
          `Bearer error="insufficient_scope", scope="${input.capability}"`,
      }),
    };
  }
  if (!await tokenScopesRemainGranted({ store: input.store, record })) {
    await input.store.deleteToken(accessToken);
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  return { ok: true, record };
}

export function launchRedirectUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const isHttps = url.protocol === "https:";
    const isLocalHttp = url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (!isHttps && !isLocalHttp) return undefined;
    if (url.pathname !== "/_takosumi/launch") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function oidcRedirectUrisValue(
  value: unknown,
): readonly string[] | undefined {
  const redirectUris = stringArrayValue(value);
  if (!redirectUris || redirectUris.length < 1 || redirectUris.length > 16) {
    return undefined;
  }
  const seen = new Set<string>();
  for (const redirectUri of redirectUris) {
    if (!isAllowedOidcRedirectUri(redirectUri) || seen.has(redirectUri)) {
      return undefined;
    }
    seen.add(redirectUri);
  }
  return redirectUris;
}

export const namespacePathPattern =
  /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){0,7}$/;

export function oidcNamespacePathValue(value: unknown): string | undefined {
  const namespacePath = stringValue(value);
  return namespacePath && namespacePathPattern.test(namespacePath)
    ? namespacePath
    : undefined;
}

export function hasRemovedOidcNamespaceAlias(
  value: Record<string, unknown>,
): boolean {
  return Object.hasOwn(value, "serviceId") ||
    Object.hasOwn(value, "service_id");
}

export function oidcIssuerUrlValue(value: unknown): string | undefined {
  const issuerUrl = stringValue(value);
  if (!issuerUrl) return undefined;
  try {
    const normalized = normalizeIssuer(issuerUrl);
    const parsed = new URL(normalized);
    return parsed.protocol === "https:" ||
        (parsed.protocol === "http:" &&
          (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

export function oidcAllowedScopesValue(
  value: unknown,
): readonly string[] | undefined {
  const scopes = stringArrayValue(value);
  if (!scopes || scopes.length < 1 || scopes.length > 32) return undefined;
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (!oidcScopeTokenPattern.test(scope) || seen.has(scope)) return undefined;
    seen.add(scope);
  }
  if (!seen.has("openid")) return undefined;
  return scopes;
}

export const oidcScopeTokenPattern = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export function isAllowedOidcRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hash === "" && (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1")));
  } catch {
    return false;
  }
}

export function oidcClientAuthMethodValue(
  value: unknown,
): OidcClientAuthMethod | undefined {
  return value === "client_secret_basic" ||
      value === "client_secret_post" ||
      value === "none"
    ? value
    : undefined;
}

export function opaqueLaunchToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}
