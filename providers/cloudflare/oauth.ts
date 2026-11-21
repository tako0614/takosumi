import type { CredentialRecipeDriverContext } from "../types.ts";
import { CloudflareCredentialError } from "./credentials.ts";
import { CredentialRecipeRefreshFailure } from "takosumi-contract/credential-recipe-host";

const SESSION = "CLOUDFLARE_OAUTH_SESSION";
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
interface Session {
  readonly clientId: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  readonly lifetimeSeconds?: number;
  readonly scopes?: readonly string[];
}

function scopesFromResponse(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 8192) {
    throw new CloudflareCredentialError("Cloudflare returned invalid permission scopes");
  }
  const scopes = [...new Set(value.split(/\s+/u).filter(Boolean))];
  if (scopes.length > 128 || scopes.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/u.test(scope))) {
    throw new CloudflareCredentialError("Cloudflare returned invalid permission scopes");
  }
  return scopes;
}

function requireScopes(granted: readonly string[] | undefined, required: readonly string[] = []): void {
  if (required.some((scope) => scope !== "offline_access" && !granted?.includes(scope))) {
    throw new CloudflareCredentialError("Cloudflare permissions changed or required scopes are missing; reconnect Cloudflare");
  }
}

/** A changed host grant must be authorized again, never inferred from account access. */
export function assertCloudflareOAuthScopes(values: Readonly<Record<string, string>>, required: readonly string[]): void {
  requireScopes(sessionFromValues(values)?.scopes, required);
}

/** Private sealed material; only CLOUDFLARE_API_TOKEN is runner-bound. */
export function cloudflareOAuthValues(input: {
  readonly tokenResponse: Readonly<Record<string, unknown>>;
  readonly clientId: string;
  readonly now: number;
  readonly previous?: Session;
  readonly requestedScopes?: readonly string[];
}): Readonly<Record<string, string>> {
  const token = input.tokenResponse.access_token;
  const ttl = input.tokenResponse.expires_in;
  if (typeof token !== "string" || !token || typeof ttl !== "number" ||
    !Number.isFinite(ttl) || ttl < 1800 || ttl > 365 * 86400) {
    throw new CloudflareCredentialError("Cloudflare did not return a usable access token and expiry");
  }
  const refresh = input.tokenResponse.refresh_token;
  // RFC 6749 permits omission only when the grant is unchanged from the
  // initial request or previous refresh. An explicit reduction is not success.
  const scopes = scopesFromResponse(input.tokenResponse.scope) ?? input.previous?.scopes ?? input.requestedScopes;
  requireScopes(scopes, input.requestedScopes);
  requireScopes(scopes, input.previous?.scopes);
  const session: Session = {
    clientId: input.clientId,
    ...(typeof refresh === "string" && refresh ? { refreshToken: refresh } :
      input.previous?.refreshToken ? { refreshToken: input.previous.refreshToken } : {}),
    expiresAt: input.now + ttl * 1000,
    lifetimeSeconds: ttl,
    ...(scopes === undefined ? {} : { scopes }),
  };
  return { CLOUDFLARE_API_TOKEN: token, [SESSION]: JSON.stringify(session) };
}

function sessionFromValues(values: Readonly<Record<string, string>>): Session | undefined {
  if (!values[SESSION]) return undefined; // Legacy OAuth connections remain readable.
  try {
    const value: unknown = JSON.parse(values[SESSION]);
    if (value && typeof value === "object" && "clientId" in value &&
      typeof value.clientId === "string" && value.clientId && "expiresAt" in value &&
      typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) &&
      (!("refreshToken" in value) || typeof value.refreshToken === "string") &&
      (!("scopes" in value) || (Array.isArray(value.scopes) && value.scopes.length <= 128 &&
        value.scopes.every((scope) => typeof scope === "string" && /^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/u.test(scope))))) return value as Session;
  } catch { /* Never expose malformed sealed material in error messages. */ }
  throw new CloudflareCredentialError("Cloudflare connection must be reconnected");
}

export function cloudflareOAuthExpiresAt(values: Readonly<Record<string, string>>): string | undefined {
  const session = sessionFromValues(values);
  return session ? new Date(session.expiresAt).toISOString() : undefined;
}

/** Default RunnerProfile permits 15 minutes; reserve at least twice that. */
export function cloudflareOAuthRefreshRequired(values: Readonly<Record<string, string>>, now: Date, minimumLifetimeSeconds = 1800): boolean {
  const session = sessionFromValues(values);
  // Persist a fresh rotation even when it cannot fit an unusually long Run;
  // subsequent dispatches reject that budget without repeatedly rotating.
  if (session?.lifetimeSeconds && session.lifetimeSeconds < minimumLifetimeSeconds) return false;
  return Boolean(session && session.expiresAt < now.getTime() + Math.max(1800, minimumLifetimeSeconds) * 1000);
}

export interface CloudflareOAuthClient {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly tokenUrl?: string;
  readonly scopes?: readonly string[];
}

export async function refreshCloudflareOAuthValues(
  input: CredentialRecipeDriverContext,
  client: CloudflareOAuthClient = {},
): Promise<Readonly<Record<string, string>> | undefined> {
  const session = sessionFromValues(input.values);
  assertCloudflareOAuthScopes(input.values, client.scopes ?? []);
  if (!session || !cloudflareOAuthRefreshRequired(input.values, input.now(), input.minimumLifetimeSeconds)) return undefined;
  if (client.clientId && client.clientId !== session.clientId) throw new CloudflareCredentialError("Cloudflare client changed; reconnect Cloudflare");
  if (!session.refreshToken) throw new CloudflareCredentialError("Cloudflare authorization expired; reconnect Cloudflare");
  const body = new URLSearchParams({ grant_type: "refresh_token",
    client_id: session.clientId, refresh_token: session.refreshToken });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  // The provider owns this fixed endpoint. Sealed user input cannot select an
  // arbitrary destination for the client secret or refresh token.
  let response: Response;
  try {
    response = await input.fetch(client.tokenUrl ?? TOKEN_URL, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  } catch { throw new CloudflareCredentialError("Cloudflare token refresh could not be completed"); }
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => null);
    if (failure && typeof failure === "object" && "error" in failure &&
      (failure.error === "temporarily_unavailable" || failure.error === "server_error")) {
      throw new CredentialRecipeRefreshFailure(true);
    }
    throw new CloudflareCredentialError("Cloudflare authorization could not be renewed; reconnect Cloudflare");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new CloudflareCredentialError("Cloudflare returned an invalid token response");
  return { ...input.values, ...cloudflareOAuthValues({
    tokenResponse: result as Record<string, unknown>, clientId: session.clientId,
    previous: session, requestedScopes: client.scopes, now: input.now().getTime(),
  }) };
}
