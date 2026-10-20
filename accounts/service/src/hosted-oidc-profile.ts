import type { OidcClientRegistration } from "./mod.ts";
import type { AccountsStore, AuthorizationCodeRecord, TokenRecord } from "./store.ts";
import { base64UrlEncodeBytes, sha256Text } from "./encoding.ts";

export const HOSTED_OIDC_SCOPES = ["openid", "email", "profile", "offline_access"] as const;
export const HOSTED_CODE_TTL_MS = 60_000;
export const HOSTED_TOKEN_TTL_SECONDS = 300;
export const HOSTED_REFRESH_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const HOSTED_REFRESH_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const HOSTED_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const HOSTED_SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

export function hostedOpaqueId(prefix: string): string {
  return prefix + base64UrlEncodeBytes(crypto.getRandomValues(new Uint8Array(32)));
}

export function hostedIssuerSessionId(sessionId: string): Promise<string> {
  return sha256Text(`takosumi-hosted-issuer-session:${sessionId}`);
}

export function validateHostedClientConfiguration(client: OidcClientRegistration): void {
  if (client.profile !== "shared-account") return;
  if (
    !client.clientId || client.clientId.length > 256 || typeof client.enabled !== "boolean" ||
    client.tokenEndpointAuthMethod !== "client_secret_basic" ||
    (!client.clientSecret && !client.clientSecretHash) ||
    !client.allowedScopes?.includes("openid") ||
    !client.allowedScopes.every((scope) => (HOSTED_OIDC_SCOPES as readonly string[]).includes(scope)) ||
    client.redirectUris.length === 0 ||
    client.redirectUris.some((uri) => {
      try {
        const url = new URL(uri);
        // The redirect origin is also named in the consent page's CSP
        // form-action, so its host may only contain DNS name characters.
        return url.protocol !== "https:" || !!url.hash || !!url.username || !!url.password ||
          !/^[A-Za-z0-9.-]+$/u.test(url.hostname);
      } catch { return true; }
    })
  ) throw new TypeError("shared-account clients require explicit enabled policy, HTTPS exact redirects, identity scopes and client_secret_basic");
}

/** All hosted grant checks consult durable current state; cookies are not grant health. */
export async function hostedGrantIsActive(input: {
  store: AccountsStore;
  record: AuthorizationCodeRecord | TokenRecord;
  client: { profile?: "shared-account"; enabled?: boolean; clientId: string; allowedScopes?: readonly string[] };
  now?: number;
  issuer?: string;
}): Promise<boolean> {
  const { record, client, store } = input;
  const now = input.now ?? Date.now();
  if (record.oidcProfile !== "shared-account") return client.profile !== "shared-account";
  if (
    client.profile !== "shared-account" || client.enabled !== true ||
    !record.issuer || (input.issuer !== undefined && record.issuer !== input.issuer) ||
    !record.sid || !record.issuerSessionId || !Number.isSafeInteger(record.authTime) ||
    record.authTime! < 0 || record.authTime! > Math.floor(now / 1000) + 60 ||
    ("audience" in record && record.audience !== undefined && record.audience !== client.clientId) ||
    record.subject !== record.takosumiSubject || record.capsuleId || record.workspaceId || record.role ||
    !record.scope.split(/\s+/u).includes("openid") ||
    !record.scope.split(/\s+/u).every((scope) => client.allowedScopes?.includes(scope) && (HOSTED_OIDC_SCOPES as readonly string[]).includes(scope)) ||
    !store.findHostedOidcGrant || !store.isHostedOidcSessionRevoked
  ) return false;
  if (await store.isHostedOidcSessionRevoked(record.issuerSessionId)) return false;
  if (!store.isHostedOidcClientRevoked || await store.isHostedOidcClientRevoked(client.clientId)) return false;
  if (!store.getAccountAuthenticationGeneration || (record.identityGeneration ?? 0) !== await store.getAccountAuthenticationGeneration(record.takosumiSubject!)) return false;
  const grant = await store.findHostedOidcGrant(record.sid);
  if (
    !grant || grant.revokedAt !== undefined || grant.absoluteExpiresAt <= now ||
    (grant.identityGeneration ?? 0) !== (record.identityGeneration ?? 0) ||
    grant.issuer !== record.issuer || grant.clientId !== client.clientId || grant.subject !== record.subject ||
    grant.issuerSessionId !== record.issuerSessionId || grant.authTime !== record.authTime ||
    !record.scope.split(/\s+/u).every((scope) => grant.scope.split(/\s+/u).includes(scope)) ||
    !(await store.findAccount(grant.subject)) || (await store.isAccountAuthenticationFenced?.(grant.subject))
  ) return false;
  if (store.findCanonicalAccount) {
    const canonical = await store.findCanonicalAccount(grant.subject);
    if (!canonical || canonical.subject !== grant.subject) return false;
  }
  // Repeat generation and revocation after awaited account reads. A completed
  // merge/global logout/client disable cannot revive an earlier snapshot.
  const currentGrant = await store.findHostedOidcGrant(record.sid);
  return currentGrant !== undefined && currentGrant.revokedAt === undefined &&
    (record.identityGeneration ?? 0) === await store.getAccountAuthenticationGeneration(record.takosumiSubject!) &&
    !(await store.isHostedOidcSessionRevoked(record.issuerSessionId)) &&
    !(await store.isHostedOidcClientRevoked(client.clientId));
}
